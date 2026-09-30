import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { V3_BASE } from '../../lib/ui-version';
import { BackLink } from '../BackLink';
import { DemoCaptureNote } from './DemoCaptureNote';

/**
 * The top of a capture form — the way out, what this screen takes, and one line
 * on what happens to it.
 *
 * The back link is a real destination rather than `history.back()`: these
 * screens are reached from a sheet that has already closed, and from a
 * notification, and from a bookmark, so "back" is not a thing the page knows.
 */
export function CaptureHeader({
  title,
  description,
  backTo = V3_BASE,
  backLabel,
}: {
  title: string;
  description: ReactNode;
  backTo?: string;
  backLabel?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <BackLink to={backTo} label={backLabel ?? t('v3.capture.backHome')} />
      <h1 className="text-title">{title}</h1>
      <p className="text-body text-muted-foreground">{description}</p>
      {/* SC-1207. Here rather than on each page: every capture screen takes
          input the demo will refuse, and a note added per page is a note the
          next capture screen forgets. Renders nothing outside the demo. */}
      <DemoCaptureNote />
    </div>
  );
}
