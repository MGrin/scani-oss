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
        // Split heavy vendor deps so the browser can fetch them in
        // parallel and cache them across deploys independent of the
        // app code. Sentry alone is ~100 KB minified and changes far
        // less often than the page itself.
        manualChunks: {
          react: ['react', 'react-dom'],
          sentry: ['@sentry/react'],
          trpc: ['@trpc/client'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
