import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteVersion } from './plugins/vite-version';

/**
 * Vite config for cloud-frontend (cloud.scani.xyz in prod).
 *
 * Two env vars with distinct audiences:
 *   - `VITE_DATA_PROVIDER_URL` (build-time `import.meta.env.*`): baked
 *     into the browser bundle. Used in production to call the data-
 *     provider at `https://api.cloud.scani.xyz`. LEAVE UNSET IN DEV so
 *     the browser uses relative `/api/auth` + `/trpc` URLs that Vite's
 *     dev-server proxies below.
 *   - `DATA_PROVIDER_PROXY_TARGET` (Node-only `process.env.*`): the URL
 *     Vite's dev-server forwards proxied requests to. In docker-compose
 *     this is `http://data-provider:8082` (compose network hostname);
 *     for bare `bun --cwd apps/cloud-frontend dev` it defaults to
 *     `http://localhost:8082`.
 */
const proxyTarget = process.env.DATA_PROVIDER_PROXY_TARGET ?? 'http://localhost:8082';

export default defineConfig({
  plugins: [react(), viteVersion()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    // 5174 is taken by the landing SPA in docker-compose; 5175 by admin;
    // cloud-frontend parks on 5176.
    port: 5176,
    host: true,
    proxy: {
      '/trpc': { target: proxyTarget, changeOrigin: true },
      '/api/auth': { target: proxyTarget, changeOrigin: true },
      // The data-provider hosts /openapi.json + /docs (Scalar UI).
      // Proxying them in dev keeps the sidebar's docs link working
      // against a same-origin relative URL when VITE_DATA_PROVIDER_URL
      // is unset.
      '/openapi.json': { target: proxyTarget, changeOrigin: true },
      '/docs': { target: proxyTarget, changeOrigin: true },
    },
  },
  build: {
    sourcemap: false,
  },
});
