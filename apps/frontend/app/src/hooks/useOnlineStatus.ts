import { useEffect, useState } from 'react';
import { isOnline } from '@/lib/auth-network';

/**
 * Whether the device believes it has a network, kept current.
 *
 * `navigator.onLine` is a weak signal — it says a route exists, not that our
 * server answers — so it is only ever used here to *soften* wording and to
 * *arm* a retry, never to decide that a request failed. The screens that use it
 * still classify their own failures.
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    // The listeners can miss a transition that happened while this was
    // mounting, and on iOS a PWA returning from the background gets `focus`
    // without either event.
    setOnline(isOnline());
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return online;
}
