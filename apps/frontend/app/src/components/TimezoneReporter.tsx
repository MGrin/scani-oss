import { useEffect } from 'react';
import { browserTimezone, shouldReportTimezone } from '@/lib/timezone';
import { trpc } from '@/lib/trpc';

/**
 * Reports this browser's IANA zone once per app load (SC-226).
 *
 * Mounted in `App.tsx` inside the authenticated layout route — above the
 * v2/v3 split, below `ProtectedRoute` — so it runs exactly once for either
 * tree and never while signed out. It renders nothing.
 *
 * It has to be *somewhere* unavoidable rather than on the Settings screen,
 * because the column it fills is what the payment reminder selects on: a zone
 * captured only by people who visit Settings is a feature that works only for
 * them, and looks like "you had no payments due" to everyone else.
 *
 * A failure is swallowed on purpose. This is a background fact about the
 * device, not something the reader asked for — a toast about it would be
 * noise, and a thrown error would take down the whole authenticated tree over
 * a timezone. The visible consequence lives on the server, where the job logs
 * how many subscribed users it cannot place.
 */
export function TimezoneReporter() {
  const userQuery = trpc.users.getCurrent.useQuery();
  const report = trpc.users.reportTimezone.useMutation();

  const storedZone = userQuery.data?.timezone;
  const isLoaded = Boolean(userQuery.data);
  const { mutate } = report;

  useEffect(() => {
    if (!isLoaded) return;
    const zone = browserTimezone();
    if (!shouldReportTimezone(zone, storedZone)) return;
    mutate({ timezone: zone as string });
  }, [isLoaded, storedZone, mutate]);

  return null;
}
