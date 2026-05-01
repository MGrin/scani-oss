import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import svgr from 'vite-plugin-svgr';
import { viteVersion } from './plugins/vite-version';

export default defineConfig({
  plugins: [
    react(),
    svgr(),
    viteVersion(),
    // Note: Using custom service worker (public/sw.js) and manifest (public/manifest.json)
    // VitePWA plugin is disabled since we manage these files manually
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/trpc': {
        target: process.env.VITE_API_URL || 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Disable source maps in production to avoid shipping full source to
    // the browser. Dev builds keep them on via the default.
    sourcemap: false,
    // IMPORTANT: do NOT manually split React or anything that imports it at
    // module-init time (Radix, react-router, react-hook-form, recharts, ...)
    // into separate chunks. When React lives in a different chunk than its
    // consumers, Rollup can emit an execution order where the consumer's
    // top-level code runs before the React chunk has initialized, producing
    // `Cannot read properties of undefined (reading 'forwardRef')` at boot.
    // We keep Vite's default vendor chunking, which handles this correctly.
  },
});
