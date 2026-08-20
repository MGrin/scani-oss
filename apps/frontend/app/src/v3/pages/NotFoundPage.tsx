import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { Compass } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, type Location } from 'react-router-dom';
import { V3_BASE } from '../lib/ui-version';

/**
 * What `/<anything v3 does not route>` renders (SC-423).
 *
 * This is the app's terminal 404 — the last route in `V3App`, below every
 * pattern it does own. Until now that catch-all forwarded to `/v2/<same path>`
 * and v2's own `NotFoundPage` was the screen that actually answered, so
 * deleting v2 without this would have made an unrouted path render nothing:
 * `V3Shell` is a layout route, and a layout route whose children all miss
 * renders `null`. That is a white page with no header, no tab bar, no console
 * error and no error boundary — and in the installed PWA there is no address
 * bar to leave it by, so it is unrecoverable without force-quitting. It has
 * shipped twice already (SC-62, SC-73).
 *
 * So the screen has three jobs, in this order, and they are the same three v2
 * settled on:
 *
 * 1. **Render inside the shell.** It is registered as a child of the `V3Shell`
 *    layout route rather than beside it, so the tab bar, the drawer and the
 *    sidebar come with it. That alone ends the dead end — every destination in
 *    the app is one tap away before the reader has read a word.
 * 2. **Say what happened, with the address in it.** "Page not found" leaves the
 *    reader guessing whether the app is broken or the link was; the address
 *    they asked for, quoted back, answers that without devtools. It is a
 *    separate block rather than interpolated into the sentence so the sentence
 *    stays reorderable — see `i18n-reorderable.test.ts`.
 * 3. **Offer an exit that is not the shell**, for the reader who arrived on a
 *    phone with the drawer closed and reads a screen before a chrome.
 *
 * It takes the location as a prop rather than calling `useLocation`, for the
 * same reason the old `CrossToClassic` did (V3-16): the tree it lives in
 * renders a location that lags the router by one commit while a view
 * transition runs, so reading the router's own location here would quote the
 * path that is arriving rather than the one that failed to match.
 */
export function NotFoundPage({ location }: { location: Location }) {
  const { t } = useTranslation();

  return (
    <PageLayout>
      <Block className="flex flex-col gap-4 p-4">
        <h1 className="flex items-center gap-2 text-title">
          <Compass className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t('v3.notFound.title')}
        </h1>
        <p className="text-body text-muted-foreground">{t('v3.notFound.body')}</p>
        <p className="break-all rounded-md border border-border bg-surface-0 px-3 py-2 font-mono text-label text-foreground">
          {`${location.pathname}${location.search}`}
        </p>
        <div>
          <Button asChild>
            <Link to={V3_BASE}>{t('v3.notFound.goHome')}</Link>
          </Button>
        </div>
      </Block>
    </PageLayout>
  );
}
