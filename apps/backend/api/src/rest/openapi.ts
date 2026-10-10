import type { OpenAPIV3_1 } from 'openapi-types';
import { AGENT_HEAVY_READS_PER_MINUTE, AGENT_REQUESTS_PER_MINUTE } from '../agent-access/limits';
import { outputJsonSchema } from '../mcp/outputs';
import { MCP_TOOLS, type McpTool } from '../mcp/tools';
import { MCP_WRITE_SUPPORT_TOOLS, MCP_WRITE_TOOLS } from '../mcp/write-tools';
import { restParamName } from './input';
import {
  REST_BASE,
  REST_ERROR_CODES,
  REST_EXCLUDED_TOOLS,
  REST_NOT_IN_V1,
  REST_ROUTES,
  type RestRoute,
} from './routes';

/**
 * The OpenAPI document for `/api/v1` (SC-1648), generated from the route
 * table and each tool's schemas. Nothing here is written by hand per route,
 * so the document cannot describe a route the handler does not serve. This
 * module reads no database, so a script can build the document without one.
 */

type Schema = Record<string, unknown>;

interface JsonInput {
  properties?: Record<string, Schema>;
  required?: string[];
}

const TOOLS: readonly McpTool[] = [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS, ...MCP_WRITE_TOOLS];

const ERRORS = {
  '400': ['BadRequest', 'The request is not valid. `issues` names each problem.'],
  '401': ['Unauthenticated', 'No token, or one that is unknown or revoked.'],
  '403': ['Forbidden', 'A write with a read-only token, or agent access is off for the account.'],
  '404': ['NotFound', "No such route, or an id that is not the token owner's."],
  '409': ['Conflict', 'The change cannot be made as things stand; nothing was changed.'],
  '429': ['RateLimited', 'A budget is spent. `Retry-After` says when to try again.'],
  '500': ['Internal', 'The request failed on the server.'],
} as const;

const DESCRIPTION = `Read and change a Scani portfolio over plain HTTP: holdings, accounts, transactions, returns, review questions, and the writes that record a movement or answer a question.

Operation ids are the names of Scani's agent tools; a description that names another operation uses its id.

## Authentication

Send a personal access token: \`Authorization: Bearer scani_pat_…\`. Create one in Scani under Settings. A token reads. A token created with "Allow changes" also writes.

## Limits

- ${AGENT_REQUESTS_PER_MINUTE} requests a minute per token.
- The heavy reads (returns, net worth, realized gains, lots) share ${AGENT_HEAVY_READS_PER_MINUTE} a minute per user, across that user's tokens.
- A spent budget answers 429 with \`Retry-After\`.

## Changes, retries and undo

Every write answers \`agentChangeId\`. \`POST ${REST_BASE}/changes/{agentChangeId}/undo\` puts back every row that change touched, exactly, and refuses when a later change touched the same rows.

Send \`Idempotency-Key\` on a write to make a retry safe: the same key and body writes once, and the repeat answers the first answer with \`replayed: true\`.

## Numbers

A quantity or a money amount is a decimal string. A field that has no value is absent, never \`null\`.

## Versioning

v1 only gains things: a route, an optional parameter, an answer field. Ignore fields you do not know. A removal or a change of type is \`/api/v2\`.

## Not in v1

${REST_NOT_IN_V1.map((row) => `- **${row.what}.** ${row.why}`).join('\n')}
${Object.entries(REST_EXCLUDED_TOOLS)
  .map(([tool, why]) => `- **\`${tool}\`** (an agent tool, not a route). ${why}`)
  .join('\n')}`;

function operation(route: RestRoute, tool: McpTool): OpenAPIV3_1.OperationObject {
  const input = tool.inputSchema as JsonInput;
  const required = new Set(input.required ?? []);
  const inPath = new Set([...route.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string));
  const journaled = Boolean(tool.writes) && !tool.unjournaled;

  const parameters: OpenAPIV3_1.ParameterObject[] = [];
  const body: Record<string, Schema> = {};
  for (const [key, property] of Object.entries(input.properties ?? {})) {
    const { description, ...schema } = property as Schema & { description?: string };
    if (inPath.has(key)) {
      parameters.push({ name: key, in: 'path', required: true, schema, description });
    } else if (route.method === 'GET') {
      parameters.push({
        name: restParamName(key),
        in: 'query',
        required: required.has(key),
        schema,
        description,
        ...(schema.type === 'array' ? { style: 'form', explode: true } : {}),
      });
    } else {
      body[key] = property;
    }
  }
  if (journaled) {
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      schema: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x21-\\x7e]+$' },
      description:
        'Makes a retry safe: the same key and body writes once. Scoped to the token. A different body under a used key answers 409.',
    });
  }

  const statuses = (
    route.method === 'POST'
      ? ['400', '401', '403', '404', '409', '429', '500']
      : ['400', '401', '403', '404', '429', '500']
  ) as (keyof typeof ERRORS)[];

  const notes = [
    tool.heavy
      ? `A heavy read: it shares ${AGENT_HEAVY_READS_PER_MINUTE} a minute per user with the other heavy reads.`
      : null,
    tool.writes ? 'Needs a token created with "Allow changes".' : null,
  ].filter(Boolean);

  return {
    operationId: tool.name,
    summary: tool.title,
    description: [tool.description, ...notes].join('\n\n'),
    tags: [route.path.split('/')[1] as string],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(Object.keys(body).length > 0
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: body,
                  required: Object.keys(body).filter((key) => required.has(key)),
                  additionalProperties: false,
                },
              },
            },
          },
        }
      : {}),
    responses: {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: outputJsonSchema(tool.name) ?? {} } },
      },
      ...Object.fromEntries(
        statuses.map((status) => [status, { $ref: `#/components/responses/${ERRORS[status][0]}` }])
      ),
    },
  };
}

export function buildRestOpenApi(): OpenAPIV3_1.Document {
  const paths: Record<string, Record<string, OpenAPIV3_1.OperationObject>> = {};
  for (const route of REST_ROUTES) {
    const tool = TOOLS.find((t) => t.name === route.tool);
    if (!tool) throw new Error(`REST route ${route.path} names no tool: ${route.tool}`);
    const item = paths[`${REST_BASE}${route.path}`] ?? {};
    item[route.method.toLowerCase()] = operation(route, tool);
    paths[`${REST_BASE}${route.path}`] = item;
  }

  const errorContent = {
    'application/json': { schema: { $ref: '#/components/schemas/Error' } },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Scani API', version: 'v1', description: DESCRIPTION },
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A Scani personal access token (`scani_pat_…`), created in Settings.',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', enum: [...REST_ERROR_CODES] },
                message: { type: 'string' },
                issues: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'On 400: one line per problem, starting with the field it is about.',
                },
              },
            },
          },
        },
      },
      responses: Object.fromEntries(
        Object.entries(ERRORS).map(([status, [name, description]]) => [
          name,
          {
            description,
            content: errorContent,
            ...(status === '429'
              ? {
                  headers: {
                    'Retry-After': {
                      schema: { type: 'integer' },
                      description: 'Seconds until the budget has room again.',
                    },
                  },
                }
              : {}),
          },
        ])
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// What a client coded against `before` would break on in `after`.
//
// It reads types, properties, required lists, enum values, where a parameter
// travels, the error body and the authentication. It does not read formats,
// bounds or patterns: a tightened `maxLength` passes it.
// ---------------------------------------------------------------------------

interface Node {
  type?: unknown;
  properties?: Record<string, Node>;
  items?: Node;
  required?: string[];
  enum?: unknown[];
  anyOf?: Node[];
  oneOf?: Node[];
}

interface Param {
  name: string;
  in?: string;
  required?: boolean;
  schema?: Node;
}

const typeOf = (node: Node | undefined) => JSON.stringify(node?.type ?? null);

function retyped(was: Node, is: Node): string | null {
  return typeOf(was) === typeOf(is)
    ? null
    : `${String(was.type ?? 'a union')} became ${String(is.type ?? 'a union')}`;
}

/** A field a client reads: it must still be there, as the type it was. */
function answerBreaks(was: Node, is: Node | undefined, at: string): string[] {
  if (!is) return [`${at}: removed`];
  const changed = retyped(was, is);
  if (changed) return [`${at}: ${changed}`];
  const variants = was.anyOf ?? was.oneOf;
  if (variants) {
    const now = (is.anyOf ?? is.oneOf ?? []).map((v) => JSON.stringify(v));
    return variants.some((v) => !now.includes(JSON.stringify(v)))
      ? [`${at}: a variant changed`]
      : [];
  }
  // A value the client handles may vanish; a new one is an addition.
  const values = is.enum
    ? (was.enum ?? [])
        .filter((value) => !is.enum?.includes(value))
        .map((value) => `${at}: no longer answers ${JSON.stringify(value)}`)
    : [];
  const stillRequired = new Set(is.required ?? []);
  const optional = (was.required ?? [])
    .filter((key) => !stillRequired.has(key) && is.properties?.[key])
    .map((key) => `${at}.${key}: may now be absent`);
  return [
    ...values,
    ...optional,
    ...Object.entries(was.properties ?? {}).flatMap(([key, child]) =>
      answerBreaks(child, is.properties?.[key], `${at}.${key}`)
    ),
    ...(was.items ? answerBreaks(was.items, is.items, `${at}[]`) : []),
  ];
}

/** A value a client sends: it must still be accepted, and nothing new may be demanded. */
function requestBreaks(was: Node, is: Node | undefined, at: string): string[] {
  if (!is) return [`${at}: removed`];
  const changed = retyped(was, is);
  if (changed) return [`${at}: ${changed}`];
  const out: string[] = [];
  if (!was.enum && is.enum) out.push(`${at}: now takes listed values only`);
  for (const value of was.enum ?? []) {
    if (is.enum && !is.enum.includes(value))
      out.push(`${at}: no longer takes ${JSON.stringify(value)}`);
  }
  for (const [key, child] of Object.entries(was.properties ?? {})) {
    out.push(...requestBreaks(child, is.properties?.[key], `${at}.${key}`));
  }
  const required = new Set(was.required ?? []);
  for (const key of is.required ?? []) {
    if (required.has(key)) continue;
    out.push(`${at}.${key}: ${was.properties?.[key] ? 'became required' : 'new and required'}`);
  }
  if (was.items) out.push(...requestBreaks(was.items, is.items, `${at}[]`));
  return out;
}

interface Operation {
  parameters?: Param[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Node }> };
  responses?: Record<string, { content?: Record<string, { schema?: Node }> }>;
}

const schemaOf = (holder: { content?: Record<string, { schema?: Node }> } | undefined) =>
  holder?.content?.['application/json']?.schema;

interface Document {
  paths?: Record<string, Record<string, Operation>>;
  security?: unknown;
  components?: { schemas?: Record<string, Node>; securitySchemes?: unknown };
}

export function breakingChanges(before: unknown, after: unknown): string[] {
  const old = before as Document;
  const now = after as Document;
  const was = old.paths ?? {};
  const is = now.paths ?? {};
  const out: string[] = [];

  const auth = (d: Document) => JSON.stringify([d.security, d.components?.securitySchemes]);
  if (auth(old) !== auth(now)) out.push('authentication: changed');
  const errorBody = old.components?.schemas?.Error;
  if (errorBody) out.push(...answerBreaks(errorBody, now.components?.schemas?.Error, 'error body'));

  for (const [path, item] of Object.entries(was)) {
    for (const [method, op] of Object.entries(item)) {
      const label = `${method.toUpperCase()} ${path}`;
      const next = is[path]?.[method];
      if (!next) {
        out.push(`${label}: removed`);
        continue;
      }

      const params = new Map((next.parameters ?? []).map((p) => [p.name, p]));
      const known = new Set<string>();
      for (const param of op.parameters ?? []) {
        known.add(param.name);
        const current = params.get(param.name);
        const at = `${label} parameter ${param.name}`;
        if (!current) {
          out.push(`${at}: removed`);
          continue;
        }
        if ((param.in ?? 'query') !== (current.in ?? 'query'))
          out.push(`${at}: moved from ${param.in ?? 'query'} to ${current.in ?? 'query'}`);
        if (!param.required && current.required) out.push(`${at}: became required`);
        out.push(...requestBreaks(param.schema ?? {}, current.schema ?? {}, at));
      }
      for (const [name, param] of params) {
        if (!known.has(name) && param.required)
          out.push(`${label} parameter ${name}: new and required`);
      }

      const body = schemaOf(op.requestBody);
      if (body) out.push(...requestBreaks(body, schemaOf(next.requestBody), `${label} body`));
      else if (next.requestBody?.required) out.push(`${label} body: new and required`);

      const answer = schemaOf(op.responses?.['200']);
      if (answer)
        out.push(...answerBreaks(answer, schemaOf(next.responses?.['200']), `${label} answer`));
    }
  }
  return out;
}
