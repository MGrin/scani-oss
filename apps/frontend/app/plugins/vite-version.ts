import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Vite plugin that generates a version.json in the build output.
 * The file contains a build hash that changes with every build,
 * allowing the app to detect when a new version is deployed.
 */
export function viteVersion(): Plugin {
  let buildHash = '';

  return {
    name: 'vite-version',
    buildStart() {
      // Generate a unique build hash from timestamp + random
      buildHash = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    },
    writeBundle(options) {
      const outDir = options.dir || resolve(process.cwd(), 'dist');
      const versionData = {
        version: buildHash,
        buildTime: new Date().toISOString(),
      };
      writeFileSync(resolve(outDir, 'version.json'), JSON.stringify(versionData));
    },
    // Also serve version.json during development
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ version: 'dev', buildTime: new Date().toISOString() }));
      });
    },
  };
}
