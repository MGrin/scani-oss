import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Use custom service worker
      injectRegister: null,
      strategies: 'injectManifest',
      srcDir: 'public',
      filename: 'sw.js',
      // Include assets
      includeAssets: [
        'favicon.ico',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'robots.txt',
        'icons/*.png',
        '.well-known/*',
      ],
      // Use manifest from public directory
      manifest: false,
      // Disable dev options to prevent conflicts
      devOptions: {
        enabled: false,
      },
    }),
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
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
