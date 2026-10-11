/**
 * THIS browser's push endpoint, or null when it holds none or cannot say. The
 * server's device count is not a substitute: it counts other devices too, so a
 * laptop would report the phone's subscription as its own.
 */
export async function readLocalPushEndpoint(): Promise<string | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    // A registration that is not ready is not an error the reader can act on.
    return null;
  }
}
