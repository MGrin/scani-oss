import type { McpTool } from '../mcp/tools';
import type { RestRoute } from './routes';

/**
 * Turns a REST request into the input of the tool its route names (SC-1648).
 *
 * Names are camelCase on the wire; a tool that takes `holding_id` is asked
 * with `holdingId`. A value that does not fit its declared type is passed on
 * as the client sent it, so the tool's own schema refuses it by name and the
 * refusal lands in the call log like any other.
 */

interface JsonProperty {
  type?: string;
  items?: { type?: string };
}

export function restParamName(toolKey: string): string {
  return toolKey.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function properties(tool: McpTool): Record<string, JsonProperty> {
  return (tool.inputSchema.properties ?? {}) as Record<string, JsonProperty>;
}

function coerce(raw: string, type: string | undefined): unknown {
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    return raw.trim() === '' || !Number.isFinite(n) ? raw : n;
  }
  if (type === 'boolean') return raw === 'true' ? true : raw === 'false' ? false : raw;
  return raw;
}

export type RestInput =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; issues: string[] };

export function restInput(
  route: RestRoute,
  tool: McpTool,
  url: URL,
  pathParams: Readonly<Record<string, string>>,
  body: unknown
): RestInput {
  const declared = properties(tool);
  const issues: string[] = [];
  const input: Record<string, unknown> = {};

  // A write's fields travel in the body, so a query string on it is a mistake.
  const queryKeys =
    route.method === 'GET'
      ? new Map(Object.keys(declared).map((key) => [restParamName(key), key]))
      : new Map<string, string>();
  for (const name of new Set(url.searchParams.keys())) {
    const key = queryKeys.get(name);
    const property = key ? declared[key] : undefined;
    if (!key || !property) {
      issues.push(`${name}: unknown parameter`);
      continue;
    }
    const values = url.searchParams.getAll(name);
    if (property.type === 'array') {
      input[key] = values.map((value) => coerce(value, property.items?.type));
    } else if (values.length > 1) {
      issues.push(`${name}: given more than once`);
    } else {
      input[key] = coerce(values[0] ?? '', property.type);
    }
  }

  if (route.method === 'POST') {
    // A write whose every field is in the path has nothing to send.
    const takesBody = Object.keys(declared).some((key) => !Object.hasOwn(pathParams, key));
    if (body === undefined && !takesBody) body = {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, issues: [...issues, '(body): expected a JSON object'] };
    }
    // `hasOwn`, not `in`: `in` also finds `__proto__` and `constructor`, and
    // assigning `__proto__` would hand the tool fields the call log never saw.
    for (const [key, value] of Object.entries(body)) {
      if (Object.hasOwn(declared, key)) input[key] = value;
      else issues.push(`${key}: unknown field`);
    }
  }

  for (const [name, value] of Object.entries(pathParams)) {
    if (Object.hasOwn(input, name) && input[name] !== value)
      issues.push(`${name}: differs from the path`);
    input[name] = value;
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, input };
}
