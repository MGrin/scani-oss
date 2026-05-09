// This file configures the initialization of Sentry on the client.
// Loaded by @sentry/nextjs automatically; DSN is the NEXT_PUBLIC_ value so
// it's embedded at build time.

import { scrubSentryBreadcrumb, scrubSentryEvent } from '@scani/shared';
import * as Sentry from '@sentry/nextjs';

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || process.env.SENTRY_RELEASE,
    tracesSampleRate: 0.1,
    // Strip PII (emails, JWTs, Authorization values) from event +
    // breadcrumb payloads before they leave the browser.
    beforeSend: scrubSentryEvent,
    beforeBreadcrumb: scrubSentryBreadcrumb,
  });
}
