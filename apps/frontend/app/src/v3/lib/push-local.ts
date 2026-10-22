import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

/**
 * THIS browser's push endpoint, or null when it holds none or cannot say. The
 * server's device count is not a substitute: it counts other devices too, so a
 * laptop would report the phone's subscription as its own.
 *
 * Read through the registration the browser already has, not `ready`: `ready`
 * never settles while no worker is active, and Settings waits for this read
 * before it shows the Notifications area (SC-1743).
 */
export async function readLocalPushEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    // A registration that cannot be read is not an error the reader can act on.
    return null;
  }
}

const LOCAL_PUSH_KEY = ['push', 'local-endpoint'] as const;

/**
 * The same read as a query, so a section that shows it is shown once it has
 * answered rather than switching from Enable to Disable under the reader
 * (SC-1743). One cache entry: the Settings list's row and the Notifications
 * section always agree.
 */
export function useLocalPushEndpoint() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: LOCAL_PUSH_KEY,
    queryFn: readLocalPushEndpoint,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const set = useCallback(
    (endpoint: string | null) => client.setQueryData(LOCAL_PUSH_KEY, endpoint),
    [client]
  );
  return { endpoint: query.data, set };
}
