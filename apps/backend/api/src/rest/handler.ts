import { renderScalarHtml, SCALAR_BUNDLE } from '@scani/config/api-reference';
import { createComponentLogger } from '@scani/logging';
import { Container } from 'typedi';
import {
  type Admission,
  type AgentDeps,
  ALL_TOOLS,
  admit,
  createAgentDeps,
  executeTool,
  refuseCall,
  type ToolOutcome,
} from '../agent-access/pipeline';
import { PersonalAccessTokenService } from '../auth/personal-access-tokens';
import { rawText } from '../mcp/routes';
import { restInput, restParamName } from './input';
import { buildRestOpenApi } from './openapi';
import { REST_BASE, type REST_ERROR_CODES, REST_ROUTES, type RestRoute } from './routes';

/**
 * `/api/v1` (SC-1648): the agent tools over plain HTTP. This file frames a
 * request and an answer; who may ask, what they may do and what is recorded
 * are the pipeline's, shared with `/mcp`.
 */

type ErrorCode = (typeof REST_ERROR_CODES)[number];

const log = createComponentLogger('rest-api');

/** `/api/v1` takes a personal access token only: an OAuth grant names `/mcp`. */
export function createRestDeps(opts: {
  accessAllowed: AgentDeps['accessAllowed'];
  limiter: AgentDeps['limiter'];
  heavyLimiter: AgentDeps['heavyLimiter'];
  publicBaseUrl?: string;
}): AgentDeps {
  return createAgentDeps({
    ...opts,
    verifyToken: (raw) => Container.get(PersonalAccessTokenService).verify(raw),
  });
}

export const REST_DOCS_PATH = `${REST_BASE}/docs`;
const REST_OPENAPI_PATH = `${REST_BASE}/openapi.json`;

/**
 * The reference page is the one HTML answer this API gives, so it is the one
 * exception to `default-src 'none'`: the pinned Scalar script, the styles it
 * injects, and requests back to this origin for the document and "try it".
 */
export const REST_DOCS_CSP = [
  "default-src 'none'",
  // The bundle's own URL, not the CDN: any other package there may not run.
  `script-src ${SCALAR_BUNDLE.src}`,
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  'font-src https://fonts.scalar.com data:',
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const openApi = buildRestOpenApi();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function failure(
  status: number,
  code: ErrorCode,
  message: string,
  extra: { issues?: string[]; headers?: Record<string, string> } = {}
): Response {
  return json(
    status,
    { error: { code, message, ...(extra.issues ? { issues: extra.issues } : {}) } },
    extra.headers
  );
}

function match(route: RestRoute, segments: string[]): Record<string, string> | null {
  const pattern = route.path.split('/').slice(1);
  if (pattern.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of pattern.entries()) {
    const segment = segments[i] as string;
    const name = /^\{(\w+)\}$/.exec(part)?.[1];
    if (name) {
      if (segment === '') return null;
      try {
        params[name] = decodeURIComponent(segment);
      } catch {
        // Not valid percent-encoding, so no id this route could name.
        return null;
      }
    } else if (part !== segment) {
      return null;
    }
  }
  return params;
}

function refusedAdmission(admission: Extract<Admission, { ok: false }>): Response {
  switch (admission.reason) {
    case 'rate_limited':
      return failure(429, 'rate_limited', 'Too many requests for this token. Retry later.', {
        headers: { 'retry-after': String(admission.retryAfterSec) },
      });
    case 'agent_access_off':
      return failure(403, 'agent_access_off', 'Agent access is not enabled for this account.');
    default:
      return failure(
        401,
        'unauthenticated',
        'Send a Scani personal access token as a Bearer token.',
        { headers: { 'www-authenticate': 'Bearer realm="scani"' } }
      );
  }
}

// What a tRPC procedure threw, as the status a REST client expects for it.
const TRPC_STATUS: Readonly<Record<string, [number, ErrorCode]>> = {
  BAD_REQUEST: [400, 'invalid_input'],
  UNPROCESSABLE_CONTENT: [400, 'invalid_input'],
  NOT_FOUND: [404, 'not_found'],
  FORBIDDEN: [403, 'forbidden'],
  CONFLICT: [409, 'conflict'],
  PRECONDITION_FAILED: [409, 'conflict'],
  busy: [409, 'conflict'],
};

// Visible ASCII, so a key survives any proxy and any log unchanged.
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;

const INTERNAL = 'The request failed on the server. Try again later.';

/** A tool's own schema names its fields; the client named them in camelCase. */
function asSent(issue: string): string {
  return issue.replace(/^[a-z]+(?:_[a-z]+)+/, restParamName);
}

function answer(outcome: ToolOutcome, rename: (issue: string) => string = asSent): Response {
  if (outcome.kind === 'ok') return json(200, outcome.value);
  if (outcome.kind === 'refused') {
    if (outcome.code === 'read_only_token') return failure(403, 'read_only_token', outcome.message);
    if (outcome.code === 'rate_limited') {
      return failure(429, 'rate_limited', outcome.message, {
        headers: { 'retry-after': String(outcome.retryAfterSec) },
      });
    }
    if (outcome.code === 'invalid_input') {
      return failure(400, 'invalid_input', 'The request is not valid.', {
        issues: (outcome.issues ?? []).map(rename),
      });
    }
  }
  const mapped = outcome.kind === 'error' ? TRPC_STATUS[outcome.code] : undefined;
  if (mapped) return failure(mapped[0], mapped[1], outcome.message);
  return failure(500, 'internal', INTERNAL);
}

/** Anything thrown outside a tool still answers in this API's error shape, never the raw message. */
export async function handleRestRequest(req: Request, deps: AgentDeps): Promise<Response> {
  try {
    return await handle(req, deps);
  } catch (error) {
    log.error(
      {
        method: req.method,
        path: new URL(req.url).pathname,
        error: error instanceof Error ? error.message : String(error),
      },
      'REST request failed outside a tool'
    );
    return failure(500, 'internal', INTERNAL);
  }
}

async function handle(req: Request, deps: AgentDeps): Promise<Response> {
  const url = new URL(req.url);
  // Neither holds user data, so neither asks for a token.
  if (req.method === 'GET' && url.pathname === REST_OPENAPI_PATH) {
    return json(
      200,
      { ...openApi, servers: [{ url: deps.publicBaseUrl ?? url.origin }] },
      { 'cache-control': 'public, max-age=300' }
    );
  }
  if (req.method === 'GET' && url.pathname === REST_DOCS_PATH) {
    return new Response(renderScalarHtml(REST_OPENAPI_PATH, 'Scani API — Reference'), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'public, max-age=300',
        'content-security-policy': REST_DOCS_CSP,
      },
    });
  }

  const segments = url.pathname.startsWith(`${REST_BASE}/`)
    ? url.pathname.slice(REST_BASE.length + 1).split('/')
    : null;
  const candidates = segments
    ? REST_ROUTES.flatMap((route) => {
        const params = match(route, segments);
        return params ? [{ route, params }] : [];
      })
    : [];
  if (candidates.length === 0) return failure(404, 'not_found', 'No such route.');
  const found = candidates.find((c) => c.route.method === req.method);
  if (!found) {
    const allow = candidates.map((c) => c.route.method).join(', ');
    return failure(405, 'method_not_allowed', `This route takes ${allow}.`, {
      headers: { allow },
    });
  }

  const admission = await admit(req, deps);
  if (!admission.ok) return refusedAdmission(admission);

  const tool = ALL_TOOLS.find((t) => t.name === found.route.tool);
  if (!tool) return failure(500, 'internal', INTERNAL);

  // `undefined` is no body at all; `null` is one that is not JSON.
  let body: unknown;
  if (req.method === 'POST') {
    const text = await req.text();
    if (text.trim() !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
  }
  const parsed = restInput(found.route, tool, url, found.params, body);
  if (!parsed.ok) {
    // These issues already carry the names the client sent.
    return answer(
      await refuseCall(tool.name, body ?? {}, admission, deps, parsed.issues),
      (issue) => issue
    );
  }

  // An undo is not journaled; its repeat already answers 409 and changes nothing.
  const journaled = Boolean(tool.writes) && !tool.unjournaled;
  const key = journaled ? req.headers.get('idempotency-key') : null;
  if (key !== null && !IDEMPOTENCY_KEY.test(key)) {
    return answer(
      await refuseCall(tool.name, parsed.input, admission, deps, [
        'Idempotency-Key: 1 to 200 visible ASCII characters, no spaces',
      ]),
      (issue) => issue
    );
  }
  return answer(
    await executeTool(tool.name, parsed.input, admission, deps, {
      idempotencyKey: key ?? undefined,
      refuseDroppedFields: true,
    })
  );
}

// biome-ignore lint/suspicious/noExplicitAny: Elysia's app type is the chain's own; the other registrars take `any` too
export function registerRestRoutes(app: any, deps: AgentDeps): void {
  const handle = ({ request, body }: { request: Request; body: unknown }) =>
    handleRestRequest(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.method === 'POST' && typeof body === 'string' ? body : undefined,
      }),
      deps
    );
  app.all(REST_BASE, handle, { parse: rawText });
  app.all(`${REST_BASE}/*`, handle, { parse: rawText });
}
