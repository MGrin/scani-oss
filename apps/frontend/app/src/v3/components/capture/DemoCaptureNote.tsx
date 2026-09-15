import { useTranslation } from 'react-i18next';
import { useIsDemo } from '@/contexts/AuthContext';

/**
 * What a write will actually do, said where the write is offered (SC-1207).
 *
 * The demo banner says the deployment is read-only, once, at the top of the
 * shell. Every way into a write then reads as ordinary: the capture sheet
 * offers all six routes, the import pages render a live file picker, and manual
 * entry enables Save the moment the form is valid. A visitor who follows the
 * most inviting control on the page learns otherwise several steps in — and
 * before SC-1210 they learned it as *"Your session ended. Sign in again"*,
 * which was false and prescribed something the demo cannot do.
 *
 * Saying it at the point of entry is the cheap half of that fix. Nothing here
 * DISABLES anything, deliberately: `trpc.ts`'s refusal is a statement about the
 * server — *"a greyed-out button is a statement about the client, and this is
 * the only one that survives someone opening a console"* — and a demo exists to
 * be poked. So this states the outcome rather than forbidding the attempt.
 *
 * The sentence deliberately does NOT say "read-only". On the integration
 * screens this note sits three lines from API-key permissions, where read-only
 * is a property of the KEY the reader is about to paste — so the one word that
 * describes the deployment most precisely is also the one most likely to be
 * read as being about something else. It names the outcome instead.
 *
 * Renders nothing anywhere but the demo, which is why callers mount it
 * unconditionally and why the committed visual baselines are unaffected — the
 * same shape as `DemoBanner`.
 *
 * `useIsDemo` rather than `useAuth`, which throws without a provider: this
 * mounts inside `CaptureHeader`, and the capture forms are render-tested
 * without one.
 */
export function DemoCaptureNote() {
  const { t } = useTranslation();
  const isDemo = useIsDemo();
  if (!isDemo) return null;

  return (
    <p data-testid="demo-capture-note" className="text-caption text-muted-foreground">
      {t('v3.capture.demoNote')}
    </p>
  );
}
