import { handleMcpRequest, type McpDeps } from './server';
import { SCANI_SKILL, SKILL_URL_PATH } from './skill';

/**
 * Elysia drains every request body before a handler runs (the tRPC plugin
 * turns parsing on app-wide, SC-1032), so the POST route claims the parse
 * step and hands the handler a request rebuilt from the raw text.
 */
export async function rawText({ request }: { request: Request }): Promise<string> {
  return request.bodyUsed ? '' : request.text();
}

// biome-ignore lint/suspicious/noExplicitAny: Elysia's app type is the chain's own; the other registrars take `any` too
export function registerMcpRoutes(app: any, deps: McpDeps): void {
  const handle = ({ request, body }: { request: Request; body: unknown }) =>
    handleMcpRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' && typeof body === 'string' ? body : undefined,
      }),
      deps
    );
  // Public: the skill holds no user data, and a user fetches it with curl.
  app.get(
    SKILL_URL_PATH,
    () =>
      new Response(SCANI_SKILL, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      })
  );
  app.post('/mcp', handle, { parse: rawText });
  app.get('/mcp', handle);
  app.delete('/mcp', handle);
}
