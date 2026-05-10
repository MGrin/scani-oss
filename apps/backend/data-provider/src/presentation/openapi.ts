import { generateOpenApiDocument } from 'trpc-openapi';
import type { AppRouter } from './router';

interface OpenApiBuildOptions {
  baseUrl: string;
  version: string;
}

/**
 * Build the OpenAPI document for the data-provider's bearer-auth tRPC
 * surface and post-process it so the spec describes how the existing
 * `/trpc/<router>.<procedure>` endpoints actually behave on the wire.
 *
 * The two key adjustments vs. trpc-openapi's default output:
 *   1. GET operations are rewritten to take a single `input` query
 *      param holding URL-encoded JSON (tRPC v10's untransformed wire
 *      format) instead of one query param per top-level zod field.
 *   2. POST request bodies are left as-is (they already match the
 *      raw-JSON-body shape this server accepts when there's no
 *      transformer configured).
 *
 * Rationale: trpc-openapi assumes you'll mount its REST adapter to
 * map flattened query params back into the input object, but this
 * service exposes one tRPC surface only — adding a second REST
 * surface would double the auth/usage/rate-limit code paths. A
 * single accurate spec over the existing endpoints is the better
 * trade-off.
 */
export function buildOpenApiDocument(
  router: AppRouter,
  { baseUrl, version }: OpenApiBuildOptions
): Record<string, unknown> {
  const doc = generateOpenApiDocument(router, {
    title: 'Scani Cloud API',
    description:
      'Scani-managed third-party integration surface (pricing, chains, tokens, AI, OG, storage, email). ' +
      'All endpoints listed here are tRPC procedures reachable over HTTP at ' +
      '`/trpc/<router>.<procedure>`. Authenticate with `Authorization: Bearer sk_live_…`. ' +
      'For TypeScript callers, the typed `@scani/cloud-client` (httpBatchLink) is the ' +
      'recommended client and uses a slightly different on-the-wire shape (batched JSON body).',
    version,
    baseUrl,
  }) as unknown as Record<string, unknown>;

  const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>> | undefined;
  if (!paths) return doc;

  for (const pathItem of Object.values(paths)) {
    const getOp = pathItem.get;
    if (!getOp) continue;
    getOp.parameters = [
      {
        name: 'input',
        in: 'query',
        required: true,
        description:
          'URL-encoded JSON object matching the procedure input schema. Example: `?input=%7B%22query%22%3A%22bitcoin%22%7D` for `{ "query": "bitcoin" }`.',
        schema: { type: 'string' },
      },
    ];
  }

  return doc;
}

/**
 * Stand-alone HTML page that boots Scalar's API reference UI from the
 * CDN against our `/openapi.json`. Inlined here so we don't take
 * `@scalar/api-reference` as a runtime dep — Scalar publishes a
 * pinned standalone bundle that handles versioning client-side.
 */
export function renderScalarHtml(specUrl: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Scani Cloud API — Reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl}"></script>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  </body>
</html>`;
}
