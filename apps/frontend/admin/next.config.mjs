import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { withSentryConfig } from '@sentry/nextjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
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
