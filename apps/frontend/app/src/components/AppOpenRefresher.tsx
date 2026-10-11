import { useEffect, useRef } from 'react';
import { useIsDemo } from '@/contexts/auth-context';
import { trpc } from '@/lib/trpc';

const HEARTBEAT_MS = 15 * 60_000;

/**
 * Asks the server to re-fetch this user's balances once per app load
 * (SC-1602), then says "still here" every 15 minutes while the tab is in
 * front. The hourly sync leaves an idle user's accounts for up to six hours,
 * so the first call is what makes coming back show fresh numbers; the
 * heartbeat is what the quarter-hour crypto pricing run selects on. Results
 * arrive over the realtime pipe; nothing here waits for them.
 *
 * Mounted beside `TimezoneReporter`, for the same reason: exactly once for
 * either tree, never while signed out. A failure is swallowed, as there.
 */
export function AppOpenRefresher() {
  const opened = trpc.users.appOpened.useMutation();
  const heartbeat = trpc.users.appHeartbeat.useMutation();
  const readOnly = useIsDemo();
  const sent = useRef(false);
  const lastSent = useRef(0);
  const openMutate = opened.mutate;
  const beatMutate = heartbeat.mutate;

  useEffect(() => {
    if (readOnly || sent.current) return;
    sent.current = true;
    lastSent.current = Date.now();
    openMutate({ requestId: crypto.randomUUID() });
  }, [openMutate, readOnly]);

  useEffect(() => {
    if (readOnly) return;
    const beatIfDue = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastSent.current < HEARTBEAT_MS) return;
      lastSent.current = Date.now();
      beatMutate();
    };
    const timer = setInterval(beatIfDue, 60_000);
    document.addEventListener('visibilitychange', beatIfDue);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', beatIfDue);
    };
  }, [beatMutate, readOnly]);

  return null;
}
