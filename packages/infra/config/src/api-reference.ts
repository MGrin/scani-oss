/**
 * Scalar's standalone API reference bundle, pinned to one version and its
 * sha384 (SC-1353). The page runs on an origin that holds a session cookie;
 * an unversioned URL would run whatever the CDN served next, with that cookie
 * in reach. The browser refuses a file whose bytes do not match. To upgrade:
 * change the version, then set the hash from
 * `curl -s <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
 *
 * One pin for every service that renders a reference (the Cloud API and
 * `/api/v1`), so an upgrade cannot leave one of them behind.
 */
export const SCALAR_BUNDLE = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.72.1/dist/browser/standalone.js',
  integrity: 'sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK',
} as const;

/**
 * A stand-alone HTML page that boots Scalar's reference UI from the CDN
 * against an OpenAPI document, so no service takes `@scalar/api-reference`
 * as a runtime dependency.
 */
export function renderScalarHtml(specUrl: string, title: string): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <script id="api-reference" data-url="${specUrl}"></script>
    <script src="${SCALAR_BUNDLE.src}" integrity="${SCALAR_BUNDLE.integrity}" crossorigin="anonymous"></script>
  </body>
</html>`;
}
