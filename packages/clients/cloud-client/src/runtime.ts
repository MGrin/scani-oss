import { addBreadcrumb } from '@scani/logging/sentry';
import { type CloudClient, createCloudClient } from './client';
import { loadCloudClientConfig } from './config';

// Process-wide singleton. Owns the env read once so the three call sites
// (StorageFacade, EmailFacade, institutions router) don't each decode
// SCANI_CLOUD_URL / SCANI_CLOUD_API_KEY independently. Tests use
// setCloudClient / resetCloudClient to swap the slot without touching env.
const UNINITIALIZED = Symbol('uninitialized-cloud-client');
type Slot = CloudClient | null | typeof UNINITIALIZED;
let slot: Slot = UNINITIALIZED;

export function getCloudClient(): CloudClient | null {
  if (slot !== UNINITIALIZED) return slot;
  const { SCANI_CLOUD_URL: url, SCANI_CLOUD_API_KEY: apiKey } = loadCloudClientConfig();
  slot =
    url && apiKey
      ? createCloudClient({
          url,
          apiKey,
          onCall: (event) => {
            addBreadcrumb({
              category: 'cloud-client',
              message: `${event.routes} → ${event.status}`,
              level:
                event.status === 'error' ||
                (typeof event.status === 'number' && event.status >= 500)
                  ? 'error'
                  : event.status === 429
                    ? 'warning'
                    : 'info',
              data: {
                routes: event.routes,
                status: event.status,
                durationMs: event.durationMs,
                requestId: event.requestId,
                ...(event.error ? { error: event.error } : {}),
              },
            });
          },
        })
      : null;
  return slot;
}

/** Test hook — inject a stub or null. */
export function setCloudClient(client: CloudClient | null): void {
  slot = client;
}

/** Test hook — force the next getCloudClient() to re-read config. */
export function resetCloudClient(): void {
  slot = UNINITIALIZED;
}
