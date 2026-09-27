import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

async function answerAssetRequest(
  request: Request,
  env: { ASSETS: { fetch: (request: Request) => Promise<Response> } }
): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') ?? '';
  const found = response.status === 304 || (response.ok && !type.startsWith('text/html'));
  if (!found) {
    return new Response('Not found\n', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  }
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(response.body, { status: response.status, headers });
}

const ASSET_ROUTES = { version: 1, include: ['/assets/*'], exclude: [] };

function workerSource(): string {
  return `const answerAssetRequest = ${answerAssetRequest.toString()};\nexport default { fetch: answerAssetRequest };\n`;
}

/** Writes the Pages `_worker.js` and `_routes.json` that guard `/assets/*` into the build output. */
export function viteMissingAsset(): Plugin {
  return {
    name: 'vite-missing-asset',
    apply: 'build',
    writeBundle(options) {
      const outDir = options.dir || resolve(process.cwd(), 'dist');
      writeFileSync(resolve(outDir, '_worker.js'), workerSource());
      writeFileSync(resolve(outDir, '_routes.json'), JSON.stringify(ASSET_ROUTES));
    },
  };
}
