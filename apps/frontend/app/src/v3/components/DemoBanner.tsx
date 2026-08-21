import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';

/**
 * The permanent "this is a demo" label (SC-466).
 *
 * Permanent, not dismissible, and in the shell rather than on the home screen:
 * a stranger arriving from a link lands wherever the link pointed, and a
 * label they can close is a label that is absent for the rest of the visit.
 * The one thing it has to do besides say what this is, is offer the way out —
 * SC-450 measured 15 signups and 2 returns, so the route from "I understand
 * the product" to "I have an account" is the whole reason the demo exists.
 *
 * Renders nothing anywhere but the demo, which is why the shell can mount it
 * unconditionally and why the committed visual baselines are unaffected.
 */
export function DemoBanner() {
  const { t } = useTranslation();
  const { isDemo, signupUrl } = useAuth();
  if (!isDemo) return null;

  return (
    <div
      data-testid="demo-banner"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b border-border bg-muted px-4 py-2 text-center text-caption text-muted-foreground"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      <span>{t('v3.shell.demo.banner')}</span>
      {signupUrl ? (
        <a
          className="font-medium text-foreground underline underline-offset-2"
          href={signupUrl}
          rel="noreferrer"
        >
          {t('v3.shell.demo.signUp')}
        </a>
      ) : null}
    </div>
  );
}
