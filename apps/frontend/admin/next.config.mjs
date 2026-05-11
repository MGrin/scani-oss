import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Security headers applied to every response. CSP shape mirrors the
// other Scani frontends (apps/frontend/{app,cloud}/public/_headers).
// `connect-src` is intentionally generous (https:, wss:) for the first
// deploy — the admin reaches the api, data-provider, BullMQ admin
// UI, and Sentry. We narrow to named origins after observing
// CSP-violation reports.
const SECURITY_HEADERS = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // HSTS only in production where TLS is guaranteed.
  ...(process.env.NODE_ENV === 'production'
    ? [
        {
          key: 'Strict-Transport-Security',
          value: 'max-age=31536000; includeSubDomains; preload',
        },
      ]
    : []),
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      { source: '/:path*', headers: SECURITY_HEADERS },
      // /auth/login must never be served from any cache. The page bakes a
      // fresh single-use challenge token into the HTML on every render;
      // a stale HTML body would yield an expired token (or worse, a
      // token that doesn't match the JS the browser has). iOS WebKit
      // tab-cache / bfcache has been observed serving stale variants
      // even after an explicit reopen, so be explicit.
      {
        source: '/auth/login',
        headers: [{ key: 'Cache-Control', value: 'no-store, must-revalidate' }],
      },
    ];
  },
  webpack(config) {
    // `@simplewebauthn/server` statically imports `cross-fetch`. Webpack
    // resolves it via its `browser` field (browser-ponyfill.js), which needs
    // XMLHttpRequest and breaks on Cloudflare Workers. Alias to a tiny local
    // shim that re-exports native edge fetch.
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'cross-fetch$': resolve(__dirname, 'src/lib/cross-fetch-shim.ts'),
    };
    return config;
  },
};

// Sentry wrapper — adds sourcemap upload + runtime instrumentation.
// Env-gated so local `bun run dev` doesn't fail without SENTRY_AUTH_TOKEN.
const sentryBuildOptions = {
  org: process.env.SENTRY_ORG,
  project: 'scani-admin',
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  disableLogger: true,
  release: { name: process.env.SENTRY_RELEASE },
};

export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, sentryBuildOptions)
  : nextConfig;
