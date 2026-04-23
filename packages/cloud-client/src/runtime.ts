/**
 * Process-wide cloud-client singleton.
 *
 * Three call sites used to each construct their own client by reading
 * `process.env.SCANI_CLOUD_URL` and `SCANI_CLOUD_API_KEY` at module load
 * (IntegrationManager, the storage facade, the institutions router). That
 * pattern made cloud-mode untestable (env mutated after import has no
 * effect) and triple-decoded the same envs.
 *
 * This module owns the env read once and hands the singleton out to every
 * consumer. Tests can swap or reset it via {@link setCloudClient} /
 * {@link resetCloudClient} without touching `process.env`.
 */

import { addBreadcrumb } from '@scani/logging/sentry';
import { type CloudClient, createCloudClient } from './index';

const UNINITIALIZED = Symbol('uninitialized-cloud-client');
type Slot = CloudClient | null | typeof UNINITIALIZED;
let slot: Slot = UNINITIALIZED;

/**
 * Returns the shared cloud client, or `null` if neither env var is set
 * (dev / OSS local-fallback mode). Result is cached after first call.
 *
 * Calls are automatically instrumented as Sentry breadcrumbs so any
 * downstream error captured by the consumer (backend / worker) carries
 * the cloud-hop trail. The breadcrumb sink is a no-op when Sentry isn't
 * initialised — frontend bundles pay nothing extra at runtime.
 */
export function getCloudClient(): CloudClient | null {
  if (slot !== UNINITIALIZED) return slot;
  const url = process.env.SCANI_CLOUD_URL;
  const key = process.env.SCANI_CLOUD_API_KEY;
  slot =
    url && key
      ? createCloudClient({
          url,
          apiKey: key,
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

/** Test hook — force the next `getCloudClient()` to re-read env. */
export function resetCloudClient(): void {
  slot = UNINITIALIZED;
}
