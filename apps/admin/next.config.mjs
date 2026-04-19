import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

export default nextConfig;
