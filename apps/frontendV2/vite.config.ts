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
});
