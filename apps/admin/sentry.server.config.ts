// Sentry init for server-side Next.js code (API routes, server components).

import * as Sentry from '@sentry/nextjs';

const DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (DSN) {
  Sentry.init({
    dsn: DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
    tracesSampleRate: 0.1,
  });
}
