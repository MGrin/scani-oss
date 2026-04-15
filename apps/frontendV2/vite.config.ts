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
    rollupOptions: {
      output: {
        // Split the large radix/vendor surface into its own chunk so the
        // main app bundle stays below the vite warning threshold and
        // cache invalidation on app changes doesn't blow away vendor code.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('@radix-ui')) return 'vendor-radix';
            if (id.includes('@tanstack') || id.includes('@trpc')) return 'vendor-data';
            if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
            if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts';
            return 'vendor';
          }
        },
      },
    },
  },
});
