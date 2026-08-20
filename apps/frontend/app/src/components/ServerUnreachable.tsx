import { ScaniLogo } from '@scani/ui/components/ScaniLogo';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { CloudOff, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { serverUnreachableCopy } from '@/lib/offline-shell';

/**
 * What the app shows when it cannot ask whether you are signed in (SC-78 §2).
 *
 * The screen this replaces was the sign-in form. Offline, an installed PWA cold
 * start landed on "Welcome / Enter your email" with no notice — which reads as
 * "you have been logged out" and is false: relaunching with the api back went
 * straight to the holdings screen, session intact. The reader had no way to
 * know that, and the obvious response to being told you are logged out is to
 * log in, which walked straight into the spinner that never resolved.
 *
 * So this screen makes exactly one claim, and it is the true one: we could not
 * reach the server. It says nothing about the session either way beyond naming
 * who this device last saw, and it never asks for an email — the way out of
 * here is the network coming back, not a fresh sign-in.
 *
 * It retries by itself when the network returns, because in `display-mode:
 * standalone` there is no reload button and no URL bar: a dead end here has no
 * escape but the app switcher. The manual Retry stays for the case
 * `navigator.onLine` gets wrong, which is most of them — it reports a route,
 * not a reachable server.
 */

interface ServerUnreachableProps {
  /** Who this device last saw signed in, if anyone. Wording only. */
  email: string | null;
  onRetry: () => Promise<void>;
}

export function ServerUnreachable({ email, onRetry }: ServerUnreachableProps) {
  const { t } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const online = useOnlineStatus();
  const copy = serverUnreachableCopy({ email, online, t });

  useEffect(() => {
    if (!online) return;
    // The provider retries on `online` too; this covers the case where the
    // network was already back before this screen mounted.
    let cancelled = false;
    setRetrying(true);
    void onRetry().finally(() => {
      if (!cancelled) setRetrying(false);
    });
    return () => {
      cancelled = true;
    };
  }, [online, onRetry]);

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
      style={{
        paddingTop: 'max(3rem, calc(3rem + env(safe-area-inset-top)))',
        paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
        paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
        paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
      }}
    >
      <div className="w-full max-w-md space-y-8 flex flex-col items-center">
        <div className="flex items-center gap-3">
          <ScaniLogo className="h-10 w-10" />
          <span className="text-3xl font-semibold tracking-tight">Scani</span>
        </div>
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <CardTitle className="text-2xl text-center">{copy.title}</CardTitle>
            <CardDescription className="text-center">{copy.subtitle}</CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4">
            <CloudOff className="mx-auto h-12 w-12 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">{copy.body}</p>
            <p className="text-sm text-muted-foreground">{copy.reassurance}</p>
            <Button
              type="button"
              className="w-full"
              disabled={retrying}
              onClick={() => {
                setRetrying(true);
                void onRetry().finally(() => setRetrying(false));
              }}
            >
              {retrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {retrying ? copy.retryingLabel : copy.retryLabel}
            </Button>
            {/* The one deliberate way out, for a reader who really does want a
                different account. */}
            <Link
              to="/auth"
              className="block text-sm text-muted-foreground underline underline-offset-4"
            >
              {copy.signInLabel}
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
