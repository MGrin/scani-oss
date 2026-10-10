/**
 * SC-1648. The OpenAPI document is generated from the route table and each
 * tool's schemas, and the committed copy is the contract a client codes
 * against: it may gain things, and a removal or a retyping is named as needing
 * `/api/v2`.
 */
import { describe, expect, test } from 'bun:test';
import { SCALAR_BUNDLE } from '@scani/config/api-reference';
import { ALL_TOOLS } from '../../src/agent-access/pipeline';
import { handleRestRequest, REST_DOCS_CSP, REST_DOCS_PATH } from '../../src/rest/handler';
import { breakingChanges, buildRestOpenApi } from '../../src/rest/openapi';
import committed from '../../src/rest/openapi.v1.json';
import { REST_EXCLUDED_TOOLS, REST_NOT_IN_V1, REST_ROUTES } from '../../src/rest/routes';
import { rest, restDeps } from '../helpers/rest-client';

// biome-ignore lint/suspicious/noExplicitAny: walking a JSON document by path
type Json = any;

const doc: Json = buildRestOpenApi();

function operations(): { route: (typeof REST_ROUTES)[number]; op: Json }[] {
  return REST_ROUTES.map((route) => ({
    route,
    op: doc.paths[`/api/v1${route.path}`]?.[route.method.toLowerCase()],
  }));
}

function find(node: Json, predicate: (n: Json) => boolean, path = ''): string[] {
  if (!node || typeof node !== 'object') return [];
  const here = predicate(node) ? [path] : [];
  return [
    ...here,
    ...Object.entries(node).flatMap(([key, inner]) => find(inner, predicate, `${path}/${key}`)),
  ];
}

describe('the generated OpenAPI document (SC-1648)', () => {
  test('one operation per route, named after its tool', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('v1');
    for (const { route, op } of operations()) {
      expect({ path: route.path, operationId: op?.operationId }).toEqual({
        path: route.path,
        operationId: route.tool,
      });
    }
    const count = Object.values(doc.paths).flatMap((item) => Object.keys(item as object)).length;
    expect(count).toBe(REST_ROUTES.length);
  });

  test('every operation describes its 200 answer: no empty schema (the SC-108 failure)', () => {
    for (const { route, op } of operations()) {
      const schema = op.responses['200'].content['application/json'].schema;
      expect({ tool: route.tool, type: schema.type }).toEqual({ tool: route.tool, type: 'object' });
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0);
    }
  });

  test('every operation names the error answers, and needs the bearer token', () => {
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: 'http',
      scheme: 'bearer',
      description: expect.stringContaining('personal access token'),
    });
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    for (const { route, op } of operations()) {
      const expected =
        route.method === 'POST'
          ? ['200', '400', '401', '403', '404', '409', '429', '500']
          : ['200', '400', '401', '403', '404', '429', '500'];
      expect({ tool: route.tool, statuses: Object.keys(op.responses).sort() }).toEqual({
        tool: route.tool,
        statuses: expected,
      });
    }
    expect(doc.components.schemas.Error.properties.error.properties.code.enum).toContain(
      'read_only_token'
    );
  });

  test('query parameters are camelCase and typed as the tool types them', () => {
    const params = (path: string) =>
      doc.paths[`/api/v1${path}`].get.parameters.map((p: Json) => [
        p.name,
        p.in,
        p.required,
        p.schema.type,
      ]);
    expect(params('/transactions')).toEqual([
      ['holdingId', 'query', false, 'string'],
      ['accountId', 'query', false, 'string'],
      ['from', 'query', false, 'string'],
      ['to', 'query', false, 'string'],
      ['limit', 'query', false, 'integer'],
      ['offset', 'query', false, 'integer'],
    ]);
    expect(params('/portfolio/allocation')).toEqual([['dimension', 'query', true, 'string']]);
    expect(params('/lots')).toEqual([['holdingIds', 'query', false, 'array']]);
    expect(find(doc.paths, (n) => typeof n.name === 'string' && n.name.includes('_'))).toEqual([]);
  });

  test('a path id is a path parameter and is not asked for again in the body', () => {
    const op = doc.paths['/api/v1/review-questions/transfers/{transactionId}/answer'].post;
    expect(op.parameters.filter((p: Json) => p.in === 'path').map((p: Json) => p.name)).toEqual([
      'transactionId',
    ]);
    const body = op.requestBody.content['application/json'].schema;
    expect(Object.keys(body.properties)).not.toContain('transactionId');
    expect(body.required).toEqual(['decision']);
    expect(op.requestBody.required).toBe(true);
  });

  test('the four journaled writes take Idempotency-Key; no other operation does', () => {
    const taking = operations()
      .filter(({ op }) => (op.parameters ?? []).some((p: Json) => p.name === 'Idempotency-Key'))
      .map(({ route }) => route.tool)
      .sort();
    expect(taking).toEqual(
      ALL_TOOLS.filter((t) => t.writes && !t.unjournaled)
        .map((t) => t.name)
        .sort()
    );
    expect(taking).toHaveLength(4);
  });

  test('the heavy reads say so', () => {
    for (const { route, op } of operations()) {
      const heavy = Boolean(ALL_TOOLS.find((t) => t.name === route.tool)?.heavy);
      expect({ tool: route.tool, says: op.description.includes('12 a minute') }).toEqual({
        tool: route.tool,
        says: heavy,
      });
    }
  });

  test('the description lists what v1 does not do', () => {
    expect(doc.info.description).toContain('## Not in v1');
    for (const row of REST_NOT_IN_V1) expect(doc.info.description).toContain(row.what);
    for (const tool of Object.keys(REST_EXCLUDED_TOOLS))
      expect(doc.info.description).toContain(tool);
  });

  test('no answer schema forbids a field v1 may add later; a body does refuse an unknown field', () => {
    const closed = find(doc, (n) => n.additionalProperties === false);
    expect(closed.filter((path) => path.includes('/responses/'))).toEqual([]);
    const bodies = operations().filter(({ op }) => op.requestBody);
    // The undo takes its one field from the path, so it has no body to describe.
    expect(bodies.map(({ route }) => route.tool).sort()).toEqual([
      'answer_balance_gap',
      'answer_transfer_review',
      'create_holdings',
      'record_movement',
    ]);
    for (const { route, op } of bodies) {
      expect({
        tool: route.tool,
        closed: op.requestBody.content['application/json'].schema.additionalProperties,
      }).toEqual({ tool: route.tool, closed: false });
    }
    expect(find(doc, (n) => '$schema' in n)).toEqual([]);
  });
});

describe('breakingChanges (SC-1648)', () => {
  const base = (): Json => structuredClone(doc);
  const summary = '/api/v1/portfolio/summary';
  const transactions = '/api/v1/transactions';
  const answer = (d: Json, path: string) =>
    d.paths[path].get.responses['200'].content['application/json'].schema;

  test('the same document has none', () => {
    expect(breakingChanges(doc, base())).toEqual([]);
  });

  test('additions are not breaking: a path, an answer field, an optional parameter', () => {
    const after = base();
    after.paths['/api/v1/new'] = { get: after.paths[summary].get };
    answer(after, summary).properties.added = { type: 'string' };
    after.paths[transactions].get.parameters.push({
      name: 'kind',
      in: 'query',
      required: false,
      schema: { type: 'string' },
    });
    expect(breakingChanges(doc, after)).toEqual([]);
  });

  test('a removed route, a removed or retyped answer field and a removed parameter are each named', () => {
    const after = base();
    delete after.paths['/api/v1/accounts'];
    delete answer(after, summary).properties.counts;
    answer(after, summary).properties.portfolioValue.properties.totalValue.type = 'number';
    after.paths[transactions].get.parameters = after.paths[transactions].get.parameters.filter(
      (p: Json) => p.name !== 'limit'
    );
    expect(breakingChanges(doc, after).sort()).toEqual([
      'GET /api/v1/accounts: removed',
      'GET /api/v1/portfolio/summary answer.counts: removed',
      'GET /api/v1/portfolio/summary answer.portfolioValue.totalValue: string became number',
      'GET /api/v1/transactions parameter limit: removed',
    ]);
  });

  test('a request that newly requires something, or stops taking a value, is named', () => {
    const after = base();
    after.paths[transactions].get.parameters[0].required = true;
    after.paths[transactions].get.parameters.push({
      name: 'must',
      in: 'query',
      required: true,
      schema: { type: 'string' },
    });
    const allocation = after.paths['/api/v1/portfolio/allocation'].get.parameters[0];
    allocation.schema.enum = allocation.schema.enum.slice(1);
    const body =
      after.paths['/api/v1/movements'].post.requestBody.content['application/json'].schema;
    body.required = [...body.required, 'note'];
    const broken = breakingChanges(doc, after);
    expect(broken).toContain('GET /api/v1/transactions parameter holdingId: became required');
    expect(broken).toContain('GET /api/v1/transactions parameter must: new and required');
    expect(broken).toContain(
      `GET /api/v1/portfolio/allocation parameter dimension: no longer takes ${JSON.stringify(doc.paths['/api/v1/portfolio/allocation'].get.parameters[0].schema.enum[0])}`
    );
    expect(broken).toContain('POST /api/v1/movements body.note: became required');
    expect(broken).toHaveLength(4);
  });

  test('quieter breaks are named too', () => {
    const after = base();
    // An answer field a client could rely on may now be absent.
    answer(after, summary).required = answer(after, summary).required.filter(
      (key: string) => key !== 'counts'
    );
    // A free-text parameter now takes listed values only.
    const from = after.paths[transactions].get.parameters.find((p: Json) => p.name === 'from');
    from.schema.enum = ['2026-01-01'];
    // A parameter moved out of the query string.
    after.paths[transactions].get.parameters.find((p: Json) => p.name === 'offset').in = 'header';
    // A write that took no body now needs one.
    after.paths['/api/v1/changes/{agentChangeId}/undo'].post.requestBody = {
      required: true,
      content: { 'application/json': { schema: { type: 'object', properties: {} } } },
    };
    // The error body and the way to sign in are part of the contract.
    delete after.components.schemas.Error.properties.error.properties.issues;
    after.components.securitySchemes.bearerAuth.scheme = 'basic';

    expect(breakingChanges(doc, after).sort()).toEqual([
      'GET /api/v1/portfolio/summary answer.counts: may now be absent',
      'GET /api/v1/transactions parameter from: now takes listed values only',
      'GET /api/v1/transactions parameter offset: moved from query to header',
      'POST /api/v1/changes/{agentChangeId}/undo body: new and required',
      'authentication: changed',
      'error body.error.issues: removed',
    ]);
  });

  test('an answer value renamed is named; a new answer value is not', () => {
    const renamed = base();
    const code = renamed.components.schemas.Error.properties.error.properties.code;
    code.enum = code.enum.map((c: string) => (c === 'not_found' ? 'missing' : c));
    expect(breakingChanges(doc, renamed)).toEqual([
      'error body.error.code: no longer answers "not_found"',
    ]);
    const added = base();
    added.components.schemas.Error.properties.error.properties.code.enum.push('teapot');
    expect(breakingChanges(doc, added)).toEqual([]);
  });
});

describe('the committed document is the contract (SC-1648)', () => {
  test('it is what the code generates', () => {
    const generated = JSON.parse(JSON.stringify(doc));
    if (Bun.deepEquals(generated, committed)) return;
    const breaks = breakingChanges(committed, generated);
    throw new Error(
      breaks.length === 0
        ? 'src/rest/openapi.v1.json is stale, and the difference only adds. Run `bun scripts/write-rest-openapi.ts` and commit the file.'
        : `The API no longer honours src/rest/openapi.v1.json. Each of these needs /api/v2, not a regenerated file:\n  ${breaks.join('\n  ')}`
    );
  });
});

describe('the document and its reference are served without a token (SC-1648)', () => {
  test('GET /api/v1/openapi.json is the document, with the server it was asked on', async () => {
    const res = await rest(null, 'GET', '/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.body.servers).toEqual([{ url: 'http://localhost' }]);
    expect({ ...res.body, servers: undefined }).toEqual({ ...committed, servers: undefined });
  });

  test('GET /api/v1/docs is the pinned Scalar page, and its policy names that one script', async () => {
    expect(REST_DOCS_PATH).toBe('/api/v1/docs');
    const res = await handleRestRequest(new Request('http://localhost/api/v1/docs'), restDeps());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('data-url="/api/v1/openapi.json"');
    expect(html).toContain(`src="${SCALAR_BUNDLE.src}"`);
    expect(html).toContain(`integrity="${SCALAR_BUNDLE.integrity}"`);
    // The whole URL, not the CDN's origin: no other package on it may run here.
    expect(REST_DOCS_CSP).toContain(`script-src ${SCALAR_BUNDLE.src};`);
    expect(REST_DOCS_CSP).toContain("default-src 'none'");
    expect(REST_DOCS_CSP).toContain("connect-src 'self'");
    expect(REST_DOCS_CSP).not.toContain('unsafe-eval');
  });
});
