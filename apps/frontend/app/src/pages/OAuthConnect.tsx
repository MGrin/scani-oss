import { ScaniLogo } from '@scani/ui/components/ScaniLogo';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Alert, AlertDescription } from '@scani/ui/ui/alert';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@scani/ui/ui/card';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { authClient } from '@/lib/auth-client';

/**
 * The two pages Scani's OAuth server sends a browser to when an AI client
 * such as claude.ai connects (SC-1615). The query string on both is signed by
 * the server and is handed back untouched as `oauth_query`.
 *
 * The api's authorize step always arrives here signed out: claude.ai links to
 * it cross-site, and the session cookie is SameSite=Strict. This page is
 * same-site, so its requests carry the session and the flow continues.
 */

function signInFirst(pathname: string, search: string): string {
  return `/auth?returnTo=${encodeURIComponent(`${pathname}${search}`)}`;
}

async function postForRedirect(path: string, body: Record<string, unknown>): Promise<string> {
  const { data, error } = await authClient.$fetch<{ url?: string; redirect_uri?: string }>(path, {
    method: 'POST',
    body,
  });
  const target = data?.url ?? data?.redirect_uri;
  if (error || !target) throw new Error(error?.message ?? 'No redirect from the server');
  return target;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </div>
  );
}

export function OAuthAuthorize() {
  const { t } = useTranslation();
  useDocumentTitle(t('oauth.continuing'));
  const { user, status } = useAuth();
  const { pathname, search } = useLocation();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user || !search) return;
    postForRedirect('/oauth2/continue', { postLogin: true, oauth_query: search.slice(1) })
      .then((target) => window.location.assign(target))
      .catch(() => setFailed(true));
  }, [user, search]);

  if (status === 'loading') return <LoadingSpinner />;
  if (!user) return <Navigate to={signInFirst(pathname, search)} replace />;

  return (
    <Frame>
      <CardContent className="flex flex-col items-center gap-3 p-6">
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>{t('oauth.failed')}</AlertDescription>
          </Alert>
        ) : (
          <>
            <LoadingSpinner />
            <p className="text-body text-muted-foreground">{t('oauth.continuing')}</p>
          </>
        )}
      </CardContent>
    </Frame>
  );
}

export function OAuthConsent() {
  const { t } = useTranslation();
  const { user, status } = useAuth();
  const { pathname, search } = useLocation();
  const clientId = new URLSearchParams(search).get('client_id') ?? '';
  const [clientName, setClientName] = useState<string | null>(null);
  useDocumentTitle(t('oauth.consent.title', { name: clientName ?? t('oauth.consent.unnamedApp') }));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!user || !clientId) return;
    void authClient
      .$fetch<{ client_name?: string }>('/oauth2/public-client', {
        method: 'GET',
        query: { client_id: clientId },
      })
      .then(({ data }) => setClientName(data?.client_name ?? null));
  }, [user, clientId]);

  if (status === 'loading') return <LoadingSpinner />;
  if (!user) return <Navigate to={signInFirst(pathname, search)} replace />;

  const answer = (accept: boolean) => {
    setBusy(true);
    postForRedirect('/oauth2/consent', { accept, oauth_query: search.slice(1) })
      .then((target) => window.location.assign(target))
      .catch(() => {
        setBusy(false);
        setFailed(true);
      });
  };

  const name = clientName ?? t('oauth.consent.unnamedApp');

  return (
    <Frame>
      <CardHeader className="flex flex-col items-center gap-3 text-center">
        <ScaniLogo />
        <h1 className="text-title">{t('oauth.consent.title', { name })}</h1>
        <CardDescription>{t('oauth.consent.account', { email: user.email })}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-label">{t('oauth.consent.canTitle')}</p>
          <p className="text-body text-muted-foreground">{t('oauth.consent.can')}</p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-label">{t('oauth.consent.cannotTitle')}</p>
          <p className="text-body text-muted-foreground">{t('oauth.consent.cannot')}</p>
        </div>
        <p className="text-caption text-muted-foreground">{t('oauth.consent.revoke')}</p>
        {failed ? (
          <Alert variant="destructive">
            <AlertDescription>{t('oauth.failed')}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1"
            disabled={busy}
            onClick={() => answer(false)}
          >
            {t('oauth.consent.deny')}
          </Button>
          <Button className="flex-1" disabled={busy} onClick={() => answer(true)}>
            {t('oauth.consent.allow')}
          </Button>
        </div>
      </CardContent>
    </Frame>
  );
}
