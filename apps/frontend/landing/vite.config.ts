import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split heavy vendor deps into their own chunks so the browser
        // can fetch them in parallel and cache them across deploys
        // independent of the app code. posthog-js is dynamically
        // imported (deferred off the critical path) — naming its chunk
        // keeps it stably cacheable.
        manualChunks: {
          react: ['react', 'react-dom'],
          posthog: ['posthog-js'],
          trpc: ['@trpc/client'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
